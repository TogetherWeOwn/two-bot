#!/usr/bin/env bash
set -euo pipefail

npm run test:postgres
npm run migrate
npm run web:views
npm run web:role
npm run verify:web-role
