import { addComment } from './clickup.js';
import { readManifest } from '../orchestrator/index.js';

export async function log(workspace, message) {
  console.log(message);
  try {
    const { task_id, clickup_api_key } = readManifest(workspace);
    if (task_id && clickup_api_key) {
      await addComment(task_id, clickup_api_key, message);
    }
  } catch {
    // never let logging break the pipeline
  }
}
