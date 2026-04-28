import { run } from './orchestrator/index.js';

const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
};

const org = get('--org');
const task_id = get('--task');
const failure_context = get('--failure');
const status = get('--status') ?? 'agent pickup';

if (!org) {
  console.error('Usage: node cli.js --org <org> [--status <status>] [--task <task_id> --failure "<context>"]');
  process.exit(1);
}

run({ org, task_id, failure_context, status }).catch(err => {
  console.error(err.message);
  process.exit(1);
});
