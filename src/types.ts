export type ListingSort = "hot" | "new" | "top" | "rising";
export type SearchSort = "relevance" | "hot" | "top" | "new" | "comments";
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
  source: "json";
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
  sort: "confidence" | "top" | "new" | "controversial" | "old" | "qa";
  limit: number;
  depth: number;
};

export type PostListResult = {
  posts: RedditPost[];
  nextCursor: string | null;
  source: "json";
};

export type PostResult = {
  post: RedditPost;
  source: "json";
};

export type CommentsResult = {
  postId: string;
  comments: RedditComment[];
  source: "json";
};

export type SearchResult = PostListResult;
