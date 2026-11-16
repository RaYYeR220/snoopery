import type { AffordanceCard, AffordancePart } from '@snoopery/schema';

const slide = (part: string, capacity: AffordancePart['capacity']): AffordancePart => ({ part, joint: 'prismatic', capacity });
const swing = (part: string, capacity: AffordancePart['capacity']): AffordancePart => ({ part, joint: 'revolute', capacity });

/** Common household furniture with the parts an articulation pass typically recovers. Sizes are W × H × D in metres. */
export const ARCHETYPES: AffordanceCard[] = [
  { objectId: 'dresser', label: 'Three-drawer dresser', sizeM: [1.2, 0.85, 0.5], parts: [slide('drawer1', 'medium'), slide('drawer2', 'medium'), slide('drawer3', 'medium')] },
  { objectId: 'nightstand', label: 'Nightstand', sizeM: [0.45, 0.6, 0.4], parts: [slide('drawer1', 'small'), swing('door', 'medium')] },
  { objectId: 'wardrobe', label: 'Two-door wardrobe', sizeM: [1.2, 2.0, 0.6], parts: [swing('door_left', 'large'), swing('door_right', 'large')] },
  { objectId: 'jewelry_box', label: 'Jewelry box', sizeM: [0.22, 0.1, 0.15], parts: [swing('lid', 'small')] },
  { objectId: 'toolbox', label: 'Metal toolbox', sizeM: [0.5, 0.24, 0.22], parts: [swing('lid', 'medium')] },
  { objectId: 'desk', label: 'Writing desk', sizeM: [1.2, 0.75, 0.6], parts: [slide('drawer1', 'medium')] },
  { objectId: 'cabinet', label: 'Kitchen wall cabinet', sizeM: [0.8, 0.7, 0.35], parts: [swing('door_left', 'large'), swing('door_right', 'large')] },
  { objectId: 'trunk', label: 'Wooden storage trunk', sizeM: [0.9, 0.5, 0.5], parts: [swing('lid', 'large')] },
  { objectId: 'bread_bin', label: 'Bread bin', sizeM: [0.42, 0.22, 0.27], parts: [swing('flap', 'medium')] },
  { objectId: 'microwave', label: 'Microwave', sizeM: [0.48, 0.28, 0.38], parts: [swing('door', 'medium')] },
  { objectId: 'mailbox', label: 'Wall mailbox', sizeM: [0.3, 0.38, 0.12], parts: [swing('flap', 'small'), swing('door', 'medium')] },
  { objectId: 'piano', label: 'Upright piano', sizeM: [1.5, 1.25, 0.6], parts: [swing('fallboard', 'small'), swing('top_lid', 'large')] },
  { objectId: 'laptop', label: 'Laptop', sizeM: [0.32, 0.02, 0.22], parts: [swing('lid', 'small')] },
  { objectId: 'filing_cabinet', label: 'Filing cabinet', sizeM: [0.47, 1.02, 0.62], parts: [slide('drawer1', 'large'), slide('drawer2', 'large'), slide('drawer3', 'large')] },
  { objectId: 'safe', label: 'Floor safe', sizeM: [0.4, 0.5, 0.4], parts: [swing('door', 'medium')] },
  { objectId: 'birdhouse', label: 'Birdhouse', sizeM: [0.2, 0.3, 0.2], parts: [swing('roof', 'small')] },
  { objectId: 'music_box', label: 'Music box', sizeM: [0.16, 0.09, 0.11], parts: [swing('lid', 'small')] },
  { objectId: 'suitcase', label: 'Hard-shell suitcase', sizeM: [0.7, 0.45, 0.27], parts: [swing('lid', 'large')] },
  { objectId: 'cookie_tin', label: 'Cookie tin', sizeM: [0.2, 0.08, 0.2], parts: [slide('lid', 'small')] },
  { objectId: 'sideboard', label: 'Sideboard', sizeM: [1.6, 0.8, 0.45], parts: [slide('drawer1', 'medium'), slide('drawer2', 'medium'), swing('door_left', 'large'), swing('door_right', 'large')] },
];

export const THEMES = [
  "a Victorian detective's study",
  'a Cold War spy safehouse',
  "grandmother's haunted flat",
  "a pirate captain's quarters",
  "a mad inventor's workshop",
  'a snowed-in mountain cabin',
  'a 1920s speakeasy',
  'a space station crew cabin',
  'an art gallery after a heist',
  'a surprise birthday gone wrong',
];
