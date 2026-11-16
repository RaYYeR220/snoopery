import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { Job } from './types';

const LABELS: Record<string, string> = {
  photo: 'Photo',
  describe: 'What opens',
  preview: 'Splat preview',
  mesh: 'True-scale mesh',
  split: 'Parts',
  articulate: 'Joints & motion',
  optimize: 'Web model',
  joints: 'Recovered joints',
  publish: 'Ready',
  source: 'Upload',
  world: 'Reconstruction',
  mirror: 'Splat',
  model: 'Model',
  rig: 'Skeleton',
  clips: 'Motions',
};

const secs = (ms?: number) => (ms === undefined ? '' : ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`);

/** Live view of one generation job: every step, its timing and its real artefact. */
export function JobCard({ jobId, token, title, onDone }: { jobId: string; token?: string; title: string; onDone?: (job: Job) => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const j = await api<Job>(`/jobs/${encodeURIComponent(jobId)}`);
        if (stop) return;
        setJob(j);
        if (j.status === 'done') onDone?.(j);
        if (j.status === 'active') timer = setTimeout(tick, 4000);
      } catch (e) {
        if (!stop) {
          setError(String((e as Error).message));
          timer = setTimeout(tick, 8000);
        }
      }
    };
    void tick();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stop = true;
      clearTimeout(timer);
      clearInterval(clock);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const retry = async (step: string) => {
    try {
      setJob(await api<Job>(`/jobs/${encodeURIComponent(jobId)}/retry`, { method: 'POST', body: JSON.stringify({ step }), token }));
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  return (
    <div className={`sn-job sn-job-${job?.status ?? 'active'}`}>
      <div className="sn-job-head">
        <strong>{title}</strong>
        <span>{job ? (job.status === 'active' ? 'working' : job.status) : 'starting'}</span>
      </div>
      <ol className="sn-steps">
        {(job?.steps ?? []).filter((s) => s.status !== 'skipped').map((s) => (
          <li key={s.name} className={`sn-step sn-step-${s.status}`}>
            <span className="sn-step-dot" />
            <span className="sn-step-name">{LABELS[s.name] ?? s.name}</span>
            <span className="sn-step-time">
              {s.status === 'running' && s.startedAt ? secs(now - Date.parse(s.startedAt)) : s.status === 'done' ? secs(s.ms) : s.status === 'queued' ? 'queued' : ''}
            </span>
            {s.status === 'failed' && (
              <span className="sn-step-error">
                {s.error} {token && <button onClick={() => retry(s.name)}>Retry</button>}
              </span>
            )}
          </li>
        ))}
      </ol>
      {job?.steps.find((s) => s.name === 'photo')?.output?.photo && <img className="sn-job-photo" src={job.steps.find((s) => s.name === 'photo')!.output!.photo} alt="" />}
      {error && <div className="sn-warn">{error}</div>}
    </div>
  );
}
