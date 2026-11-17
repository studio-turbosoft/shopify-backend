// Small class-transformer helpers for DTOs: @Transform(blankToNull), @Transform(cleanTags).

/** "" or "   " → null, so a blank optional field clears the column. */
export const blankToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? null : value;

/** Trim tags, drop blanks and case-insensitive duplicates. Non-arrays pass through for the validators to reject. */
export const cleanTags = ({ value }: { value: unknown }) => {
  if (!Array.isArray(value) || !value.every((t) => typeof t === 'string')) return value;
  const tags: string[] = [];
  for (const raw of value as string[]) {
    const tag = raw.trim();
    const isDuplicate = tags.some((t) => t.toLowerCase() === tag.toLowerCase());
    if (tag && !isDuplicate) tags.push(tag);
  }
  return tags;
};
