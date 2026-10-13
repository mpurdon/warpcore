// Import the groups so they register, then export the surface. Anything
// that runs a command imports from here, so the registry is always full.

import './view';
import './project';
import './canvas';
import './scenario';
import './account';
import './query';
import './holodeck';

export { run, runFromUi } from './dispatch';
export { all, get, blocked, confirmQuestion, paletteRows, shortcuts, summaryOf, titleOf, toolSpecs, commandForTool } from './registry';
export type { CommandSpec, CommandResult, Receipt, Source } from './types';
