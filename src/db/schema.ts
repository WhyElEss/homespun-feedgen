export type DatabaseSchema = {
  post: Post
  sub_state: SubState
  post_label: PostLabel
  label_check: LabelCheck
  label_state: LabelState
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

// A label from Bluesky's moderation service on a stored post. One row per
// (post, value); a negation deletes the row. See src/labels.ts.
export type PostLabel = {
  uri: string
  val: string
  cts: string
  exp: string | null
}

// A stored post whose labels have been asked for once.
export type LabelCheck = {
  uri: string
  checkedAt: string
}

// The label stream's cursor: a sequence number, not a time.
export type LabelState = {
  service: string
  cursor: number
}
