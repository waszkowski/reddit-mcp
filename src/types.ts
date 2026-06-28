export type ListingSort = "new" | "top";
export type SearchSort = "relevance" | "new" | "top";
export type CommentSort = "top" | "new" | "old";
export type Timeframe = "hour" | "day" | "week" | "month" | "year" | "all";

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
  query?: string;
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

/**
 * Coverage metadata for a score-ranked ("top") listing. Because the archive only
 * sorts by time, "top" re-ranks a capped window of the most recent posts: when
 * `windowFullyScanned` is false the ranking is "top among the newest
 * `candidatesScanned` posts", not the true top of the whole timeframe.
 */
export type TopCoverage = {
  candidatesScanned: number;
  windowFullyScanned: boolean;
};

export type PostListResult = {
  posts: RedditPost[];
  nextCursor: string | null;
  topCoverage?: TopCoverage;
};

export type PostResult = {
  post: RedditPost;
};

export type CommentsResult = {
  postId: string;
  comments: RedditComment[];
};

export type SearchResult = PostListResult;
