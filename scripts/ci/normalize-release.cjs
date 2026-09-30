// release-please v17 synthesizes the seeded v0.1.0 even when it is unpublished.
// Only repair that bootstrap link; subsequent real-tag comparisons stay intact.
// Config has a PR header but no changelog header override:
// https://github.com/googleapis/release-please/blob/v17.6.0/schemas/config.json
// Contents updates use the current blob SHA and explicit release branch:
// https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents
module.exports = async function normalize({github, repo, pr}) {
  const branch = 'release-please--branches--main--components--two-bot';
  // v17.6.0 emits no PR when its body is unchanged, including after a failed repair:
  // https://github.com/googleapis/release-please/blob/v17.6.0/src/manifest.ts#L1089-L1101
  // Recover only the exact same-repo/main release branch, then revalidate below.
  // https://docs.github.com/en/rest/pulls/pulls#list-pull-requests
  if (!pr) {
    const candidates = await github.paginate(github.rest.pulls.list, {
      ...repo, state: 'open', base: 'main', head: `${repo.owner}:${branch}`, per_page: 100,
    });
    if (candidates.length === 0) return null;
    if (candidates.length !== 1) throw new Error('Ambiguous release PR recovery');
    pr = {number: candidates[0].number, headBranchName: branch};
  }
  if (!Number.isSafeInteger(pr.number) || pr.number < 1 ||
      pr.headBranchName !== branch) {
    throw new Error('Unexpected release-please PR output');
  }
  const {data: current} = await github.rest.pulls.get({...repo, pull_number: pr.number});
  const fullName = `${repo.owner}/${repo.repo}`;
  if (current.state !== 'open' || current.base.ref !== 'main' ||
      current.head.repo?.full_name !== fullName || current.head.ref !== pr.headBranchName ||
      !current.labels?.some(({name}) => name === 'autorelease: pending')) {
    throw new Error('Refusing to modify a non-release PR');
  }
  const {data: file} = await github.rest.repos.getContent({
    ...repo, path: 'CHANGELOG.md', ref: current.head.sha,
  });
  if (file.type !== 'file' || file.encoding !== 'base64') throw new Error('Unexpected changelog response');
  const changelog = Buffer.from(file.content, 'base64').toString('utf8');
  const body = current.body ?? '';
  const heading = /^## \[(\d+\.\d+\.\d+)\]\((https:\/\/github\.com\/[^\s)]+\/compare\/v0\.1\.0\.\.\.v\1)\)/m;
  const match = changelog.match(heading) ?? body.match(heading);
  if (!match) return pr;
  const [, version, compare] = match;
  if (compare !== `https://github.com/${fullName}/compare/v0.1.0...v${version}`) {
    throw new Error('Unexpected bootstrap comparison repository');
  }
  try {
    await github.rest.git.getRef({...repo, ref: 'tags/v0.1.0'});
    return pr; // A published baseline is valid; never rewrite it.
  } catch (error) {
    if (error.status !== 404) throw error; // Auth/rate-limit/server errors are not absent tags.
  }
  const release = `https://github.com/${fullName}/releases/tag/v${version}`;
  const correctedHeading = `## [${version}](${release})`;
  const oldHeading = `## [${version}](${compare})`;
  const correctedChangelog = changelog.replace(oldHeading, correctedHeading);
  const correctedBody = body.replace(oldHeading, correctedHeading);
  // A prior attempt can have committed the file but failed the body update.
  // Repair each independently, preserving notes, release markers and footer.
  if (correctedChangelog !== changelog) {
    await github.rest.repos.createOrUpdateFileContents({
      ...repo, path: 'CHANGELOG.md', branch: pr.headBranchName, sha: file.sha,
      message: 'chore(release): correct unpublished bootstrap comparison\n\nCo-Authored-By: Paperclip <noreply@paperclip.ing>',
      content: Buffer.from(correctedChangelog).toString('base64'),
    });
  }
  if (correctedBody !== body) {
    await github.rest.pulls.update({...repo, pull_number: pr.number, body: correctedBody});
  }
  return pr; // Dispatch against the repaired branch only after all writes succeeded.
};
