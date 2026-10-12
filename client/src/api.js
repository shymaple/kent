async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.error ?? `${res.status} ${res.statusText}`);
    // Some refusals carry something to act on (which subtasks are still open),
    // so the caller gets the body as well as the sentence.
    err.code = data?.code;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  settings: () => request('/settings'),
  saveSettings: (body) => request('/settings', { method: 'PUT', body }),
  connectSlack: (token) => request('/slack/token', { method: 'POST', body: { token } }),
  disconnectSlack: () => request('/slack/token', { method: 'DELETE' }),
  diagnoseSlack: () => request('/slack/diagnose'),

  gmailStatus: () => request('/gmail/status'),
  connectGmail: (client_id, client_secret) =>
    request('/gmail/connect', { method: 'POST', body: { client_id, client_secret } }),
  disconnectGmail: () => request('/gmail', { method: 'DELETE' }),

  channels: () => request('/channels'),
  setChannelExcluded: (id, is_excluded) =>
    request(`/channels/${id}`, { method: 'PUT', body: { is_excluded } }),
  refreshChannels: () => request('/channels/refresh', { method: 'POST' }),

  people: (q) => request(`/people${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  setPriorityPerson: (id, is_priority) =>
    request(`/people/${id}`, { method: 'PUT', body: { is_priority } }),

  inbox: () => request('/inbox'),
  approve: (id, edits) => request(`/inbox/${id}/approve`, { method: 'POST', body: edits ?? {} }),
  dismiss: (id) => request(`/inbox/${id}/dismiss`, { method: 'POST' }),

  tasks: () => request('/tasks'),
  createTask: (body) => request('/tasks', { method: 'POST', body }),
  importSlack: (url, list_id) => request('/tasks/from-slack', { method: 'POST', body: { url, list_id } }),
  updateTask: (id, body) => request(`/tasks/${id}`, { method: 'PATCH', body }),
  deleteTask: (id) => request(`/tasks/${id}`, { method: 'DELETE' }),

  lists: () => request('/lists'),
  createList: (name) => request('/lists', { method: 'POST', body: { name } }),
  updateList: (id, body) => request(`/lists/${id}`, { method: 'PATCH', body }),
  deleteList: (id) => request(`/lists/${id}`, { method: 'DELETE' }),
  reorderList: (id, ids) => request(`/lists/${id}/reorder`, { method: 'POST', body: { ids } }),

  subtasks: (taskId) => request(`/tasks/${taskId}/subtasks`),
  addSubtask: (taskId, title) => request(`/tasks/${taskId}/subtasks`, { method: 'POST', body: { title } }),
  updateSubtask: (id, body) => request(`/subtasks/${id}`, { method: 'PATCH', body }),
  deleteSubtask: (id) => request(`/subtasks/${id}`, { method: 'DELETE' }),

  comments: (taskId) => request(`/tasks/${taskId}/comments`),
  addComment: (taskId, body, kind) =>
    request(`/tasks/${taskId}/comments`, { method: 'POST', body: { body, kind } }),
  deleteComment: (id) => request(`/comments/${id}`, { method: 'DELETE' }),
  draftComment: (taskId, intent) =>
    request(`/tasks/${taskId}/comment-draft`, { method: 'POST', body: { intent } }),
  sendComment: (id) => request(`/comments/${id}/send`, { method: 'POST' }),

  learnTone: () => request('/tone/learn', { method: 'POST' }),
  forgetTone: () => request('/tone', { method: 'DELETE' }),

  search: (q) => request(`/search?q=${encodeURIComponent(q)}`),

  syncStatus: () => request('/sync/status'),
  runSync: () => request('/sync/run', { method: 'POST' }),
};
