import { z } from "zod";

const subredditString = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_\/\-]+$/);

const pagination = z.object({
  limit: z.number().int().min(1).max(25).default(10),
  after: z.string().min(1).optional(),
});

export const listSubredditPostsSchema = pagination.extend({
  subreddit: subredditString,
  sort: z.enum(["hot", "new", "top", "rising"]).default("hot"),
  timeframe: z.enum(["hour", "day", "week", "month", "year", "all"]).optional(),
});

const getPostBaseSchema = z.object({
  postId: z.string().min(1).optional(),
  postUrl: z.string().url().optional(),
});

export const getPostSchema = getPostBaseSchema.refine((value) => Boolean(value.postId || value.postUrl), {
  message: "Provide postId or postUrl",
});

export const getCommentsSchema = getPostBaseSchema
  .extend({
    sort: z.enum(["confidence", "top", "new", "controversial", "old", "qa"]).default("top"),
    limit: z.number().int().min(1).max(50).default(20),
    depth: z.number().int().min(1).max(6).default(3),
  })
  .refine((value) => Boolean(value.postId || value.postUrl), {
    message: "Provide postId or postUrl",
  });

export const searchSchema = pagination.extend({
  query: z.string().min(1).max(512),
  subreddit: subredditString.optional(),
  sort: z.enum(["relevance", "hot", "top", "new", "comments"]).default("relevance"),
  timeframe: z.enum(["hour", "day", "week", "month", "year", "all"]).default("week"),
});

export const readLargeResultSchema = z.object({
  filePath: z.string().min(1),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(256).max(20000).default(8000),
});

export type ListSubredditPostsArgs = z.infer<typeof listSubredditPostsSchema>;
export type GetPostArgs = z.infer<typeof getPostSchema>;
export type GetCommentsArgs = z.infer<typeof getCommentsSchema>;
export type SearchArgs = z.infer<typeof searchSchema>;
export type ReadLargeResultArgs = z.infer<typeof readLargeResultSchema>;
