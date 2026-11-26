// What the setup dialog reads from dws: whether it is installed, the accounts signed in to it, and
// the people and groups a search finds. Never a credential: dws keeps those to itself.
import * as z from 'zod'
import { schemas, type DingTalkProfile } from '../dingtalk-domain'
import {
  dwsFailure,
  jsonChildren,
  jsonString,
  parseJson,
  type DwsBoundary
} from './dingtalk-dws-boundary'

type Exec = Pick<DwsBoundary, 'exec'>

export type DwsProfile = {
  profile: DingTalkProfile
  corpName: string
  userName: string
  /** dws's own word for the sign-in, e.g. whether it expired; empty when it says none. */
  status: string
  current: boolean
}
export type DwsPerson = { openDingTalkId: string; name: string; title: string }
export type DwsGroup = { groupId: string; name: string }

/** The installed dws's version, or why there is none. */
export async function dwsVersion(dws: Exec): Promise<{ version: string } | { missing: string }> {
  const run = await dws.exec(null, ['version'])
  if (run.notStarted || run.code !== 0) {
    return {
      missing: run.notStarted
        ? 'dws is not installed'
        : dwsFailure(run.code, run.stdout, run.stderr)
    }
  }
  const parsed = z.object({ version: z.string() }).passthrough().safeParse(parseJson(run.stdout))
  return { version: parsed.success ? parsed.data.version : 'unknown' }
}

const Profiles = z.object({
  profiles: z
    .array(
      z
        .object({
          profile: z.string(),
          corpName: z.string().default(''),
          userName: z.string().default(''),
          status: z.string().default(''),
          isCurrent: z.boolean().default(false)
        })
        .passthrough()
    )
    .default([])
})

export async function dwsProfiles(dws: Exec): Promise<DwsProfile[]> {
  const run = await dws.exec(null, ['profile', 'list'])
  const parsed = Profiles.safeParse(parseJson(run.stdout))
  if (run.code !== 0 || !parsed.success) {
    throw new Error(dwsFailure(run.code, run.stdout, run.stderr))
  }
  return parsed.data.profiles.flatMap((entry) => {
    const profile = schemas.Profile.safeParse(entry.profile)
    return profile.success
      ? [
          {
            profile: profile.data,
            corpName: entry.corpName,
            userName: entry.userName,
            status: entry.status,
            current: entry.isCurrent
          }
        ]
      : []
  })
}

/** Every object at any depth of `value` whose `key` is a non-empty string, with that string. */
function recordsWith(value: unknown, key: string, depth = 0): { id: string; row: unknown }[] {
  if (depth > 6) {
    return []
  }
  const id = jsonString(value, key)
  if (id) {
    return [{ id, row: value }]
  }
  return jsonChildren(value).flatMap((child) => recordsWith(child, key, depth + 1))
}

const text = (row: unknown, ...keys: string[]): string =>
  keys.map((key) => jsonString(row, key)).find(Boolean) ?? ''

async function search(dws: Exec, profile: DingTalkProfile, args: string[]): Promise<unknown> {
  const run = await dws.exec(profile, args)
  if (run.code !== 0) {
    throw new Error(dwsFailure(run.code, run.stdout, run.stderr))
  }
  return parseJson(run.stdout)
}

export async function dwsSearchPeople(
  dws: Exec,
  profile: DingTalkProfile,
  query: string
): Promise<DwsPerson[]> {
  const found = await search(dws, profile, ['contact', '+search-user', '--query', query])
  const seen = new Set<string>()
  return recordsWith(found, 'openDingTalkId').flatMap(({ id, row }) => {
    if (seen.has(id)) {
      return []
    }
    seen.add(id)
    return [
      { openDingTalkId: id, name: text(row, 'name', 'flowerName'), title: text(row, 'title') }
    ]
  })
}

export async function dwsSearchGroups(
  dws: Exec,
  profile: DingTalkProfile,
  query: string
): Promise<DwsGroup[]> {
  const found = await search(dws, profile, ['chat', '+chat-search', '--query', query])
  const seen = new Set<string>()
  return recordsWith(found, 'openConversationId').flatMap(({ id, row }) => {
    if (seen.has(id)) {
      return []
    }
    seen.add(id)
    return [{ groupId: id, name: text(row, 'title', 'name', 'groupName') }]
  })
}
