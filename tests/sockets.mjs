export function connect(address, options) {
  if (!globalThis.__testConnect) throw new Error('A real socket must not be opened in a unit test');
  return globalThis.__testConnect(address, options);
}
