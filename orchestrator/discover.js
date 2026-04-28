import fs from 'fs';
import path from 'path';
import { listRepos } from '../tools/github.js';

export async function discoverRepos(org, token, workspacePaths = {}) {
  const repos = await listRepos(org, token);

  return repos.filter(repo => {
    const configPath = path.join(workspacePaths[repo.name] ?? '', 'swarm.config.json');
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return config.enabled !== false;
    } catch {
      return true;
    }
  });
}
