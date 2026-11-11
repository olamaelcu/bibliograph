import { defineLexiconConfig } from '@atcute/lex-cli';

export default defineLexiconConfig({
  generate: {
    // @atcute/lex-cli models records and queries, not alpha `type: "space"`
    // declarations. The static lex publisher still builds those from
    // lexicons/net/olamaelcu/livtet/*.json; only code generation skips them.
    files: [
      'lexicons/com/**/*.json',
      'lexicons/codegen/community/lexicon/media/**/*.json',
      'lexicons/net/olamaelcu/livtet/biblio/**/*.json',
      'lexicons/net/olamaelcu/livtet/actor/**/*.json',
    ],
    outdir: 'src/lib/server/lexicons/',
    imports: ['@atcute/atproto'],
  },
});
