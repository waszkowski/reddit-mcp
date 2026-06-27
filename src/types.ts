export type ListingSort = "new" | "top";
export type SearchSort = "relevance" | "new" | "top";
export type CommentSort = "top" | "new" | "old";
export type Timeframe = "hour" | "day" | "week" | "month" | "year" | "all";

/**
 * Where a normalized record came from. The Arctic-Shift archive API is the
 * primary backend; "rss" is reserved for results that originate from a Reddit
 * RSS feed before they are enriched (e.g. global search discovery).
 */
export type RedditSource = "arctic-shift" | "rss";

export type RedditPost = {
  id: string;
  title: string;
  selfText: string;
  author: string;
  subreddit: string;
  url: string;
  permalink: string;
  score: number;
  numComments: number;
  createdUtc: number;
  nsfw: boolean;
  spoiler: boolean;
  flair: string | null;
  source: RedditSource;
};

export type RedditComment = {
  id: string;
  parentId: string | null;
  postId: string;
  subreddit: string;
  author: string;
  body: string;
  score: number;
  createdUtc: number;
  permalink: string;
  depth: number;
};

export type ListPostsInput = {
  subreddit: string;
  sort: ListingSort;
  limit: number;
  after?: string;
  timeframe?: Timeframe;
};

export type SearchInput = {
  query: string;
  subreddit?: string;
  author?: string;
  sort: SearchSort;
  timeframe: Timeframe;
  limit: number;
  after?: string;
};

export type GetPostInput = {
  postId?: string;
  postUrl?: string;
};

export type GetCommentsInput = GetPostInput & {
  sort: CommentSort;
  limit: number;
  depth: number;
};

export type PostListResult = {
  posts: RedditPost[];
  nextCursor: string | null;
  source: RedditSource;
};

export type PostResult = {
  post: RedditPost;
  source: RedditSource;
};

export type CommentsResult = {
  postId: string;
  comments: RedditComment[];
  source: RedditSource;
};

export type SearchResult = PostListResult;

/**
 * Backend contract used by {@link RedditService}. Depending on the interface
 * (rather than a concrete client) keeps the door open for an alternative
 * backend (e.g. an RSS-only fallback) without touching the service/tool layer.
 */
export interface RedditDataClient {
  listSubredditPosts(input: ListPostsInput): Promise<PostListResult>;
  getPost(input: GetPostInput): Promise<PostResult>;
  getComments(input: GetCommentsInput): Promise<CommentsResult>;
  search(input: SearchInput): Promise<SearchResult>;
}
