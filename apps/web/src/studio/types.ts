import type { AffordanceCard, Joint, Puzzle, Vec3 } from '@snoopery/schema';

export interface StepState {
  name: string;
  status: 'pending' | 'queued' | 'running' | 'done' | 'failed' | 'skipped';
  ms?: number;
  startedAt?: string;
  output?: Record<string, any>;
  error?: string;
}
export interface Job {
  id: string;
  kind: 'object' | 'room' | 'character';
  status: 'active' | 'done' | 'failed';
  steps: StepState[];
  input: Record<string, any>;
  createdAt: string;
}

export interface ObjectDoc {
  id: string;
  label: string;
  category: string;
  photo: string;
  status: 'building' | 'ready' | 'failed';
  previewPly?: string;
  meshGlb?: string;
  partsGlb?: string;
  articulatedGlb?: string;
  webGlb?: string;
  joints?: Joint[];
  card?: AffordanceCard;
  jointSource?: 'urdf' | 'animation' | 'inferred';
  jointNotes?: string[];
  urdfPackage?: string;
  motionPrompt?: string;
}

export interface SpaceDoc {
  id: string;
  title: string;
  source: 'reconstruction' | 'generation' | 'library';
  splatUrl: string;
  format: 'spz' | 'ply' | 'sog';
  panoUrl?: string;
  spawn?: { pos: Vec3; yaw: number; pitch: number };
  transform?: number[];
}

export interface Library {
  objects: ObjectDoc[];
  spaces: SpaceDoc[];
  characters: unknown[];
}

export interface Placement {
  objectId: string;
  position: Vec3;
  rotationY: number;
  scale: number;
  cutout?: { center: Vec3; size: Vec3 };
}

export interface DraftLocal {
  id: string;
  token: string;
  title: string;
  spaceId: string;
  spawn: { pos: Vec3; yaw: number; pitch: number };
  splatTransform: number[];
  placements: Placement[];
  puzzle?: Puzzle;
}

export interface DesignResult {
  ok: boolean;
  puzzle?: Puzzle;
  verdict?: { solvable: boolean; minSteps: number; proof: unknown[]; issues: { code: string; detail: string }[] };
  rounds: number;
  transcript: { round: number; issues: { code: string; detail: string }[] }[];
  title?: string;
  intro?: string;
  error?: string;
}

export const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** Z-up scans → Y-up: rotate −90° about X. */
export const Z_UP_TO_Y_UP = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
