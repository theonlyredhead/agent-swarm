import express from 'express';
import { run } from './orchestrator/index.js';
import { orgs } from './config/orgs.js';

const app = express();
app.use(express.json());

app.post('/trigger', async (req, res) => {
  const { org, task_id, failure_context, source } = req.body;

  if (!org || !task_id || !failure_context) {
    return res.status(400).json({ error: 'org, task_id, and failure_context are required' });
  }

  if (!orgs[org]) {
    return res.status(400).json({ error: `Unknown org: ${org}` });
  }

  const jobId = `${Date.now()}`;
  console.log(`[server] Job ${jobId} received — org=${org} task=${task_id} source=${source ?? 'direct'}`);

  // Respond immediately, run async
  res.json({ status: 'accepted', job_id: jobId });

  run({ org, task_id, failure_context }).catch(err =>
    console.error(`[server] Job ${jobId} error: ${err.message}`)
  );
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(`[server] Listening on :${PORT}`));
