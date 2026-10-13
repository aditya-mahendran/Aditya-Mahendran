import type { DropdownLists, Topic } from '../domain/types.js';

/**
 * Dropdown values as documented for the workbook. The Graph store reads the
 * real lists from data validation at startup; these seed the in-memory store.
 */
export function defaultLists(topics: Topic[]): DropdownLists {
  const panels = topics.map((t) => t.panel);
  return {
    priority: ['High', 'Medium', 'Low'],
    status: [
      'Potential Outreach',
      'Outreach 1 Sent',
      'Outreach 2 Sent',
      'Meeting Scheduled',
      'Formal Invite Sent',
      'Interested',
      'Confirmed',
      'Unresponsive',
      'Unavailable',
      'Declined',
      'Declined - Unavailable',
    ],
    confirmed: ['YES 🥳', 'Yes'],
    alum: ['Yes', 'No', '--'],
    speakerType: ['Panelist', 'Moderator'],
    panelA: panels,
    panelB: panels,
  };
}
