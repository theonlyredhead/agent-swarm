async function cu(method, path, apiKey, body) {
  const res = await fetch(`https://api.clickup.com/api/v2${path}`, {
    method,
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`ClickUp ${method} ${path} failed: ${res.status}`);
  return res.json();
}

export const getTask = (taskId, apiKey) => cu('GET', `/task/${taskId}`, apiKey);

export const addComment = (taskId, apiKey, text) =>
  cu('POST', `/task/${taskId}/comment`, apiKey, { comment_text: text });

export const updateStatus = (taskId, apiKey, status) =>
  cu('PUT', `/task/${taskId}`, apiKey, { status });

export const filterTasks = (listId, apiKey, status) =>
  cu('GET', `/list/${listId}/task?statuses[]=${encodeURIComponent(status)}`, apiKey);
