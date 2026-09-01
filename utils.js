// utils.js — Personal Log shared utilities
// Imported by dashboard.js and app.js (people screen)

/**
 * Write an audit note to a person's notes field when their contact interval changes.
 * Appends a datestamped line: "[DD Mon YYYY] Frequency changed from X → Y days"
 */
export async function writeIntervalChangeNote(db, personId, oldInterval, newInterval, existingNotes) {
  const stamp = new Date().toLocaleDateString('en-AU', {
    day: 'numeric', month: 'short', year: 'numeric'
  });
  const note = `[${stamp}] Contact frequency changed from ${oldInterval} → ${newInterval} days`;
  const updatedNotes = existingNotes
    ? existingNotes + '\n\n' + note
    : note;

  const { error } = await db
    .from('people')
    .update({ contactintervaldays: newInterval, notes: updatedNotes })
    .eq('id', personId);

  return { error, updatedNotes };
}
