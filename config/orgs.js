export const orgs = {
  'nation-management': {
    githubToken: process.env.NATION_GH_TOKEN,
    clickupApiKey: process.env.NATION_CU_KEY,
    clickupWorkspaceId: process.env.NATION_CU_WORKSPACE,
    defaultBranch: 'main',
    prTargetBranch: 'main',
  },
  'coronation-property': {
    githubToken: process.env.CORONATION_GH_TOKEN,
    clickupApiKey: process.env.CORONATION_CU_KEY,
    clickupWorkspaceId: process.env.CORONATION_CU_WORKSPACE,
    defaultBranch: 'develop',
    prTargetBranch: 'develop',
  },
};

export function getOrg(name) {
  const config = orgs[name];
  if (!config) throw new Error(`Unknown org: ${name}`);
  return config;
}
