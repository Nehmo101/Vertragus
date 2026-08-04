/**
 * i18n keys of the shared profile-editor help texts (`profile.help.*`).
 * Kept in one map because several fields (model, effort, multi-agent) appear
 * in more than one section and must stay word-for-word identical. Render with
 * `t(HELP.<field>)`.
 */
export const HELP = {
  profileName: 'profile.help.profileName',
  workingDir: 'profile.help.workingDir',
  setupCommands: 'profile.help.setupCommands',
  githubAuth: 'profile.help.githubAuth',
  generateFromRepo: 'profile.help.generateFromRepo',
  agentWorkingDir: 'profile.help.agentWorkingDir',
  mode: 'profile.help.mode',
  orchestratorProvider: 'profile.help.orchestratorProvider',
  permissionMode: 'profile.help.permissionMode',
  model: 'profile.help.model',
  effort: 'profile.help.effort',
  plannerMode: 'profile.help.plannerMode',
  routingMode: 'profile.help.routingMode',
  maxParallel: 'profile.help.maxParallel',
  maxRetries: 'profile.help.maxRetries',
  multiAgent: 'profile.help.multiAgent',
  autoPrMode: 'profile.help.autoPrMode',
  prStrategy: 'profile.help.prStrategy',
  baseBranch: 'profile.help.baseBranch',
  qualityGates: 'profile.help.qualityGates',
  autoGitMode: 'profile.help.autoGitMode',
  autoGitBranch: 'profile.help.autoGitBranch',
  role: 'profile.help.role',
  agentProvider: 'profile.help.agentProvider',
  count: 'profile.help.count',
  yolo: 'profile.help.yolo',
  orchestrated: 'profile.help.orchestrated',
  skills: 'profile.help.skills',
  fallbackModels: 'profile.help.fallbackModels',
  strengths: 'profile.help.strengths',
  weaknesses: 'profile.help.weaknesses',
  benchmark: 'profile.help.benchmark',
  applyLearnings: 'profile.help.applyLearnings'
} as const
