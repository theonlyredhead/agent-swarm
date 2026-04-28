export const orgs = {
  'nation-management': {
    githubToken: process.env.GH_NATION_TOKEN,
    clickupApiKey: process.env.CLICKUP_API_KEY,
    clickupListId: process.env.CLICKUP_LIST_ID,
    defaultBranch: 'main',
    prTargetBranch: 'main',
    statusDone: 'PR raised',
    statusFailed: 'Review',
  },
  'coronation-property': {
    githubToken: process.env.GH_CORONATION_TOKEN,
    clickupApiKey: process.env.CLICKUP_API_KEY,
    clickupListId: process.env.CLICKUP_LIST_ID,
    defaultBranch: 'main',
    prTargetBranch: 'main',
    statusDone: 'PR raised',
    statusFailed: 'Review',
  },
};

export function getOrg(name) {
  const config = orgs[name];
  if (!config) throw new Error(`Unknown org: ${name}`);
  return config;
}
