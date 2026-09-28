/** OpenClaw's own attachment convention. Rocky captures the model's text and
 *  bypasses OpenClaw's channel, so the marker is never consumed and prints to
 *  the user verbatim. Parse it into a delivery instead. */
const MARKER = /^[ \t]*MEDIA:[ \t]*(\S+)[ \t]*$/gm;
const CONTAINER_WORKSPACE = '/tenant/workspace';

/** @returns {{text: string, paths: string[]}} workspace-relative paths */
export function extractMediaMarkers(input) {
  const body = String(input ?? '');
  const paths = [];
  const text = body.replace(MARKER, (_line, raw) => {
    const rel = String(raw).startsWith(CONTAINER_WORKSPACE)
      ? raw.slice(CONTAINER_WORKSPACE.length).replace(/^\/+/, '')
      : String(raw).replace(/^\/+/, '');
    if (rel) paths.push(rel);
    return '';
  });
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), paths: [...new Set(paths)] };
}
