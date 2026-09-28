const FENCE = /```[\w-]*\n?([\s\S]*?)```/g;
const INLINE_CODE = /`([^`\n]+)`/g;
const BOLD = /(^|[^*])\*\*([^*\n]+)\*\*(?!\*)/g;
const HEADING = /^#{1,6}\s+(.+)$/gm;
const BULLET = /^[ \t]*[-*+][ \t]+/gm;
const MD_LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
const HR = /^[ \t]*([-*_])\1{2,}[ \t]*$/gm;

/**
 * WhatsApp is not Markdown. It uses *bold*, _italic_, ~strike~ and ```code```,
 * and renders anything else literally — so a model writing **bold** produces
 * visible asterisks, and `## Heading` shows the hashes. This normalises the
 * subset models reach for into what WhatsApp actually renders.
 */
export function toWhatsAppText(input) {
  // Managed-block markers live in the injected files; they must never be echoed.
  input = String(input ?? '').replace(/<!--[\s\S]*?-->/g, '');
  let text = String(input ?? '');
  if (!text.trim()) return '';

  const blocks = [];
  text = text.replace(FENCE, (_, body) => {
    blocks.push(body.replace(/\n+$/, ''));
    return `\u0000CODE${blocks.length - 1}\u0000`;
  });

  text = text.replace(MD_LINK, (_, label, url) => (label.trim() === url ? url : `${label}: ${url}`));
  text = text.replace(HEADING, (_, body) => `*${body.trim()}*`);
  text = text.replace(BOLD, (_, before, body) => `${before}*${body}*`);
  text = text.replace(INLINE_CODE, (_, body) => body);
  text = text.replace(BULLET, '• ');
  text = text.replace(HR, '');

  text = text.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => '```\n' + blocks[Number(i)] + '\n```');

  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
