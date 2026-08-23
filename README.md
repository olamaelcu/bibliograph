# Bibliograph

A collection of tools for bibliographic work in one project:

- An [ATProto appview][1] for:
  - resolving book information in a uniform way conforming to [the proposal
    made by Olamaelcu][2]
  - fetching reviews published in the Atmosphere [using microcosm for discovery](#network-discovery)

The end goal of this project is to provide the appview that [Livtet][] will
leverage to interface with the ATProto ecosystem - it's published in the open
to allow for simpler interoperability with other products and projects but
designed for the needs of Livtet.

## Discovery

Discovery for things like reviews happen in a few ways:

### Network Discovery

Bibliograph leverages <https://constellation.microcosm.blue/> to find book
reviews specific to Bibliograph written into the Atmosphere as well as records
ingested from TAP of the expected NSID
`net.olamaelcu.livtet.biblio.bookReview`. This allows for (near-)real time
analysis of book reviews on protocol from Livtet. For compatibility with other
applications like [Bookhive][], Bibliograph normalizes those reviews into
Bibliograph reviews so they can appear to Bibliograph-powered applications.

### Material Discovery

Information is sourced from a few places:

- Book information is sourced from Google Books
- Author information is _gleamed_ from Wikipedia and OpenLibrary

[1]: https://atproto.com/guides/glossary#app-view
[2]: https://www.olamaelcu.net/blog/2026/book-lexicon
[livtet]: https://livtet.olamaelcu.net
[bookhive]: https://bookhive.buzz/
