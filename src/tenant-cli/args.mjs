export function parseTenantArgs(argv) {
  const args = [...argv];
  const resource = args.shift() || '';
  const action = args.shift() || '';
  const options = {};
  const positionals = [];

  while (args.length) {
    const item = args.shift();
    if (!item.startsWith('--')) {
      positionals.push(item);
      continue;
    }
    const raw = item.slice(2);
    const eq = raw.indexOf('=');
    if (eq >= 0) {
      options[raw.slice(0, eq)] = raw.slice(eq + 1);
      continue;
    }
    if (args[0] && !args[0].startsWith('--')) options[raw] = args.shift();
    else options[raw] = true;
  }

  return { resource, action, options, positionals };
}

export function requireOption(options, name) {
  const value = options[name];
  if (value == null || value === '') throw new Error(`Missing required option --${name}`);
  return String(value);
}
