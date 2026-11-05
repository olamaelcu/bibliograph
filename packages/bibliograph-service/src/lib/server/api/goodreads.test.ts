import test from "node:test";
import assert from "node:assert/strict";
import {
  GoodreadsBlockedError,
  fetchGoodreadsBook,
  fetchGoodreadsFormat,
  goodreadsBookIdFromSearch,
  parseGoodreadsAuthor,
  parseGoodreadsBook,
  parseGoodreadsFormat,
  parseGoodreadsSearch,
} from "./goodreads";

test("reads the pagesFormat paragraph", () => {
  const html =
    '<div><p data-testid="pagesFormat">196 pages, Hardcover</p></div>';
  assert.deepEqual(parseGoodreadsFormat(html), {
    pages: 196,
    format: "hardcover",
  });
});

test("normalizes a paperback binding", () => {
  const html = '<p data-testid="pagesFormat">328 pages, Paperback</p>';
  assert.deepEqual(parseGoodreadsFormat(html), {
    pages: 328,
    format: "paperback",
  });
});

test("returns null when the field is absent", () => {
  assert.equal(parseGoodreadsFormat("<p>Not the field</p>"), null);
});

test("finds the first book id in a search result", () => {
  const html =
    '<a href="/book/show/32889465-private-government">Private Government</a>';
  assert.equal(goodreadsBookIdFromSearch(html), "32889465");
  assert.equal(goodreadsBookIdFromSearch("<p>no result</p>"), null);
});

test("reads genres, identifiers, publication, and publisher", () => {
  const payload = {
    props: {
      pageProps: {
        apolloState: {
          "Book:kca://book/amzn1.gr.book.v1.test": {
            __typename: "Book",
            title: "Short title",
            titleComplete: "The Complete Title",
            details: {
              __typename: "BookDetails",
              asin: "B000TEST",
              format: "Paperback",
              numPages: 320,
              publicationTime: Date.UTC(2020, 0, 2),
              publisher: "Test Press",
              isbn: "0306406152",
              isbn13: "9780306406157",
              language: { __typename: "Language", name: "English" },
            },
            bookGenres: [
              {
                __typename: "BookGenre",
                genre: {
                  __typename: "Genre",
                  name: "Fiction",
                  webUrl: "https://www.goodreads.com/genres/fiction",
                },
              },
            ],
            primaryContributorEdge: {
              __typename: "BookContributorEdge",
              role: "Author",
              node: {
                __ref: "Contributor:kca://author/amzn1.gr.author.v1.test",
              },
            },
            secondaryContributorEdges: [],
          },
          "Contributor:kca://author/amzn1.gr.author.v1.test": {
            __typename: "Contributor",
            name: "Test Author",
            webUrl: "https://www.goodreads.com/author/show/1.Test_Author",
            profileImageUrl: "https://images.gr-assets.com/authors/1p8/1.jpg",
          },
        },
      },
    },
  };
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script>`;
  assert.deepEqual(
    parseGoodreadsBook(html, "https://www.goodreads.com/book/show/1"),
    {
      url: "https://www.goodreads.com/book/show/1",
      title: "The Complete Title",
      pages: 320,
      format: "paperback",
      isbn10: "0306406152",
      isbn13: "9780306406157",
      asin: "B000TEST",
      publishedYear: 2020,
      publishedDate: "2020-01-02",
      publisher: "Test Press",
      language: "English",
      genres: [
        { name: "Fiction", url: "https://www.goodreads.com/genres/fiction" },
      ],
      contributors: [
        {
          name: "Test Author",
          role: "Author",
          url: "https://www.goodreads.com/author/show/1.Test_Author",
          imageUrl: "https://images.gr-assets.com/authors/1p8/1.jpg",
        },
      ],
    },
  );
});

test("falls back to the pagesFormat paragraph without Next data", () => {
  assert.deepEqual(
    parseGoodreadsBook(
      '<p data-testid="pagesFormat">196 pages, Hardcover</p>' +
        '<a href="https://www.goodreads.com/genres/fiction">Fiction</a>',
      "https://www.goodreads.com/book/show/2",
    ),
    {
      url: "https://www.goodreads.com/book/show/2",
      pages: 196,
      format: "hardcover",
      genres: [
        { name: "Fiction", url: "https://www.goodreads.com/genres/fiction" },
      ],
      contributors: [],
    },
  );
});

test("reads an author portrait from the author page", () => {
  const html =
    "<meta content='Test Author' property='og:title'>" +
    "<meta content='https://images.gr-assets.com/authors/1p8/1.jpg' property='og:image'>";
  assert.deepEqual(
    parseGoodreadsAuthor(
      html,
      "https://www.goodreads.com/author/show/1.Test_Author",
    ),
    {
      url: "https://www.goodreads.com/author/show/1.Test_Author",
      name: "Test Author",
      imageUrl: "https://images.gr-assets.com/authors/1p8/1.jpg",
    },
  );
});

test("parses the modern general search result cards", () => {
  const html = `
    <span>of over <!-- -->6,749<!-- --> results</span>
    <div class="Book" data-testid="book-item-kca://book/1">
      <img data-testid="responsive-image" src="https://m.media-amazon.com/images/S/compressed.photo.goodreads.com/books/1i/23692271.jpg" />
      <span data-testid="book-item-title"><a href="/book/show/23692271">Sapiens: A Brief History of Humankind</a></span>
      <span data-testid="book-item-contributors"><a class="ContributorLink" href="https://www.goodreads.com/author/show/1"><span class="ContributorLink__name" data-testid="name">Yuval Noah Harari</span></a></span>
      <span data-testid="book-item-publication-year">Published <!-- -->2015</span>
    </div>`;
  assert.deepEqual(parseGoodreadsSearch(html), {
    hits: [
      {
        id: "23692271",
        title: "Sapiens: A Brief History of Humankind",
        authors: ["Yuval Noah Harari"],
        coverImageUrl:
          "https://m.media-amazon.com/images/S/compressed.photo.goodreads.com/books/1i/23692271.jpg",
        publishedYear: 2015,
      },
    ],
    total: 6749,
  });
});

test("reports an anti-bot response as blocked, not missing", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(null, { status: 202 })) as typeof fetch;
    await assert.rejects(
      fetchGoodreadsBook("9780691176512"),
      (err: unknown) =>
        err instanceof GoodreadsBlockedError && err.status === 202,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("follows the search page cookie bounce", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; cookie?: string }[] = [];
  try {
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({ url, cookie: headers?.cookie });
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: {
            location: url,
            "set-cookie": "session=abc; Path=/",
          },
        });
      }
      if (calls.length === 2) {
        return new Response(
          '<a href="/book/show/32889465-private-government">x</a>',
          { status: 200 },
        );
      }
      if (calls.length === 3) {
        return new Response(null, {
          status: 302,
          headers: { location: url, "set-cookie": "page=1; Path=/" },
        });
      }
      return new Response(
        '<p data-testid="pagesFormat">196 pages, Hardcover</p>',
        { status: 200 },
      );
    }) as typeof fetch;

    const found = await fetchGoodreadsFormat("9780691176512");
    assert.deepEqual(found, {
      url: "https://www.goodreads.com/book/show/32889465",
      pages: 196,
      format: "hardcover",
    });
    assert.match(calls[1]?.cookie ?? "", /session=abc/);
    assert.match(calls[3]?.cookie ?? "", /page=1/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
