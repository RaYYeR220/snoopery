// Browser-safe subset: game rules and solver, no model client.
export { verify, solve, type Issue, type IssueCode, type Verdict, type VerifyOptions } from './verify';
export { initialState, reduce, compile, canOpen, canTake, canExit, progressOf, type Model, type PlayState, type Progress, type Rejection } from './state';
