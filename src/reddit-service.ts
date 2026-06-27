import {
  CommentsResult,
  GetCommentsInput,
  GetPostInput,
  ListPostsInput,
  PostListResult,
  PostResult,
  RedditDataClient,
  SearchInput,
  SearchResult,
} from "./types.js";

export class RedditService {
  private readonly client: RedditDataClient;

  constructor(client: RedditDataClient) {
    this.client = client;
  }

  listSubredditPosts(input: ListPostsInput): Promise<PostListResult> {
    return this.client.listSubredditPosts(input);
  }

  getPost(input: GetPostInput): Promise<PostResult> {
    return this.client.getPost(input);
  }

  getComments(input: GetCommentsInput): Promise<CommentsResult> {
    return this.client.getComments(input);
  }

  search(input: SearchInput): Promise<SearchResult> {
    return this.client.search(input);
  }
}
