import { listRepos } from '../tools/github.js';
import { exec } from '../tools/shell.js';
import path from 'path';

const STALENESS_DAYS = parseInt(process.env.STALENESS_DAYS ?? '90');

export async function discoverRepos(org, token, workspacePaths) {
  const repos = await listRepos(org, token);

  // Check each cloned repo for swarm.config.json enabled: false
  return repos.filter(repo => {
    const configPath = path.join(workspacePaths?.[repo.name] ?? '', 'swarm.config.json');
    try {
      const config = JSON.parse(require('fs').readFileSync(configPath, 'utf8'));
      return config.enabled !== false;
    } catch {
      return true; // no config = opt-in by default
    }
  });
}
