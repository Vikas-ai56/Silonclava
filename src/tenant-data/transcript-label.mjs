export const INBOUND_LABEL = 'User';
export const OUTBOUND_LABEL = 'Model response';

export function speakerLabel(direction) {
  return direction === 'inbound' ? INBOUND_LABEL : OUTBOUND_LABEL;
}

export function transcriptLine(message) {
  return `${speakerLabel(message.direction)}: ${message.text}`;
}
