// Element definitions on the server too, so Svelte renders the tags as custom
// elements. Web Awesome's shadow DOM is not server-rendered; the slotted light
// DOM (all of the page content) is, which is what matters for the docs.
import '$lib/webawesome/components';
