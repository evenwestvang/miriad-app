/**
 * @mention Parser Module
 *
 * Utilities for parsing @mentions from message content and determining routing.
 */

export {
  parseMentions,
  determineRouting,
  stripMentions,
  type ParsedMentions,
  type RoutingResult,
  type ChannelRoster,
} from './parser.js';
