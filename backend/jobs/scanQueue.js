'use strict';

const jobs = new Map();

function createJob(url, options = {}) {
  const id = 'scan_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
  const job = {
    id, url, options,
    status: 'pending', progress: 0, progressText: 'Se inițializează...',
    result: null, error: null,
    createdAt: new Date().toISOString(),
    startedAt: null, completedAt: null,
    version: 'hybrid',
  };
  jobs.set(id, job);
  console.log('[QUEUE] Job created:', id, 'for', url);
  return job;
}

function updateJob(id, updates) {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, updates);
  jobs.set(id, job);
  return job;
}

function getJob(id) { return jobs.get(id) || null; }
function getAllJobs() { return Array.from(jobs.values()).sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt)); }

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (new Date(job.createdAt).getTime() < now - 3600000) jobs.delete(id);
  }
}, 3600000);

module.exports = { createJob, updateJob, getJob, getAllJobs };
