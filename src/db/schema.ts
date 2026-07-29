export type DatabaseSchema = {
  post: Post
  sub_state: SubState
}

export type Post = {
  uri: string
  cid: string
  indexedAt: string
  // rkey of the feed this row belongs to. A post matching several feeds is
  // stored once per feed, so each feed can be pruned on its own schedule.
  feed: string
}

export type SubState = {
  service: string
  cursor: number
}
