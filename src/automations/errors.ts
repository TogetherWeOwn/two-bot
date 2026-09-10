export class CommandCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandCapacityError';
  }
}
