export async function listRepos(org, token) {
  const repos = [];
  let page = 1;

  while (true) {
    const res = await fetch(
      `https://api.github.com/orgs/${org}/repos?per_page=100&page=${page}&sort=pushed`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } }
    );
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    repos.push(...batch);
    if (batch.length < 100) break;
    page++;
  }

  return repos
    .filter(r => !r.archived && !r.disabled)
    .filter(r => {
      const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
      return new Date(r.pushed_at).getTime() > cutoff;
    })
    .map(r => ({
      name: r.name,
      full_name: r.full_name,
      default_branch: r.default_branch,
      clone_url: r.clone_url,
      description: r.description ?? '',
      topics: r.topics ?? [],
    }));
}

export async function createPR({ org, repo, token, title, body, head, base }) {
  // Check if a PR already exists for this branch — return its URL if so
  const existing = await fetch(
    `https://api.github.com/repos/${org}/${repo}/pulls?head=${org}:${head}&state=open`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } }
  );
  const existingData = await existing.json();
  if (Array.isArray(existingData) && existingData.length > 0) {
    return existingData[0].html_url; // PR already exists — return it
  }

  const res = await fetch(`https://api.github.com/repos/${org}/${repo}/pulls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title, body, head, base }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`GitHub PR failed: ${JSON.stringify(data)}`);
  return data.html_url;
}

export async function repositoryDispatch({ org, repo, token, eventType, payload }) {
  const res = await fetch(`https://api.github.com/repos/${org}/${repo}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ event_type: eventType, client_payload: payload }),
  });
  if (!res.ok) throw new Error(`Dispatch failed: ${res.status}`);
}
