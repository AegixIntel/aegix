export { normalizeTransaction, detectTransactionClass } from "./normalizer.js";
export { PARSER_VERSION } from "./types.js";
export type {
  NormalizeInput,
  NormalizerResult,
  ParsedInstruction,
  ParsedTransactionLike,
  ProgramParser
} from "./types.js";
export { PROTOCOL_PARSERS, parserFor, programLabelFor, protocolCategoryFor } from "./programs/registry.js";
export {
  KNOWN_PROGRAM_IDS,
  isAssociatedTokenProgram,
  isStakeProgram,
  isSystemProgram,
  isTokenProgram,
  parseSplTransfer,
  parseSystemTransfer
} from "./programs/system.js";
