export function voiceCommand(text) {
  const said = String(text)
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\bmaxim\s+us\b/g, 'maximus')
    .replace(/\s+/g, ' ')
    .trim();
  if (/\b(?:hide|hyde)\s+maximus\b/.test(said)) return 'hide';
  if (/\b(?:rise|rize)\s+maximus\b/.test(said)) return 'rise';
  return null;
}
