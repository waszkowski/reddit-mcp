import { RedditJsonClient } from "./reddit-json-client.js";
import {
  CommentsResult,
  GetCommentsInput,
  GetPostInput,
  ListPostsInput,
  PostListResult,
  PostResult,
  SearchInput,
  SearchResult,
} from "./types.js";

export class RedditService {
  private readonly jsonClient: RedditJsonClient;

  constructor(jsonClient: RedditJsonClient) {
    this.jsonClient = jsonClient;
  }

  listSubredditPosts(input: ListPostsInput): Promise<PostListResult> {
    return this.jsonClient.listSubredditPosts(input);
  }

  getPost(input: GetPostInput): Promise<PostResult> {
    return this.jsonClient.getPost(input);
  }

  getComments(input: GetCommentsInput): Promise<CommentsResult> {
    return this.jsonClient.getComments(input);
  }

  search(input: SearchInput): Promise<SearchResult> {
    return this.jsonClient.search(input);
  }
}
