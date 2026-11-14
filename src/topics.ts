import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { Journal, type Topic } from './intake-journal.js';

type Binding = Omit<Topic,'cwd'>;
export interface TopicRuntime { topic: Topic; state: string; journal: Journal }

function binding(value: unknown): Binding {
  if (!value || typeof value !== 'object') throw new Error('Expected a configured topic');
  const { repository, repoId, installation } = value as Binding;
  if (typeof repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
      !Number.isSafeInteger(repoId) || repoId <= 0 || !Number.isSafeInteger(installation) || installation <= 0) {
    throw new Error('Invalid repository name or numeric installation/repository ID');
  }
  return { repository, repoId, installation };
}

export function topicKey(installation: number, repoId: number): string { return installation+'/'+repoId; }

export function configuredTopics(root: string, env = process.env) {
  const additional: unknown = JSON.parse(env.JAM_ADDITIONAL_TOPICS || '[]');
  if (!Array.isArray(additional)) throw new Error('JAM_ADDITIONAL_TOPICS must be an array');
  const topics = [binding({repository:env.JAM_REPOSITORY, repoId:Number(env.JAM_REPOSITORY_ID), installation:Number(env.JAM_INSTALLATION_ID)}),
    ...additional.map(binding)];
  if (new Set(topics.map(topic=>topic.repoId)).size !== topics.length ||
      new Set(topics.map(topic=>topic.repository.toLowerCase())).size !== topics.length) throw new Error('Duplicate repository binding');
  return topics.map((topic,index) => {
    const state = index===0 ? root : join(root,'topics',topicKey(topic.installation,topic.repoId));
    return { topic:{...topic,cwd:join(state,'leo')},state };
  });
}

export async function openTopics(root: string): Promise<Map<string,TopicRuntime>> {
  const routes = new Map<string,TopicRuntime>();
  try {
    for (const {topic,state} of configuredTopics(root)) {
      await mkdir(topic.cwd,{recursive:true,mode:0o700});
      const journal = new Journal(join(state,'intake.sqlite'));
      routes.set(topicKey(topic.installation,topic.repoId),{topic,state,journal});
      journal.start(topic);
    }
    return routes;
  } catch (err) {
    for (const route of routes.values()) route.journal.db.close();
    throw err;
  }
}
