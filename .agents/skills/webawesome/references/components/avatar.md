# Avatar

`<wa-avatar>`

Stable [Media](https://webawesome.com/docs/components/?category=media) [Since 2.0](https://webawesome.com/docs/resources/changelog#wa_200)

Avatars represent a person or object with an image, initials, or icon. Use them in lists, comments, and profiles to give users visual context at a glance.

```html
<wa-avatar label="User avatar"></wa-avatar>
```

By default, a generic icon will be shown. You can personalize avatars by adding [images](#image), [initials](#initials), and [custom icons](#custom-icon). You should always provide a `label` for assistive devices.

## API

### Importing

If you're using the autoloader or a hosted project, components load on demand — no manual import needed. To cherry-pick a component manually, use one of the following snippets.

\*\*CDN\*\*

Import this component directly from the CDN:

```js
import 'https://ka-f.webawesome.com/webawesome@3.12.0/components/avatar/avatar.js';
```

\*\*npm\*\*

After installing Web Awesome via npm, import this component:

```js
import '@awesome.me/webawesome/dist/components/avatar/avatar.js';
```

\*\*Self-Hosted\*\*

If you're self-hosting Web Awesome, import this component from your server:

```js
import './webawesome/dist/components/avatar/avatar.js';
```

\*\*React\*\*

To import this component for React 18 or below, use the following code:

```js
import WaAvatar from '@awesome.me/webawesome/dist/react/avatar/index.js';
```

### Slots

| Name | Description |
| --- | --- |
| \`icon\` | \`

### Attributes & Properties

| Name | Description | Reflects |
| --- | --- | --- |
| \`image\` image | \`string\` The image source to use for the avatar. Type Default '' | |
| \`initials\` initials | \`string\` Initials to use as a fallback when no image is available (1-2 characters max recommended). Type Default '' | |
| \`label\` label | \`string\` A label to use to describe the avatar to assistive devices. Type Default '' | |
| \`loading\` loading | \`'eager' \\| 'lazy'\` Indicates how the browser should load the image. Type Default 'eager' | |
| \`shape\` shape | \`'circle' \\| 'square' \\| 'rounded'\` The shape of the avatar. Type Default 'circle' | |

### Events

| Name | Description |
| --- | --- |
| \`wa-error\` | The image could not be loaded. This may because of an invalid URL, a temporary network condition, or some unknown cause. |

### CSS Custom Properties

| Name | Description |
| --- | --- |
| \`--size\` | The size of the avatar. |

### CSS Parts

| Name | Description | CSS selector |
| --- | --- | --- |
| \`icon\` | The container that wraps the avatar's icon. | \`::part(icon)\` |
| \`image\` | \`image\` The avatar . Only shown when the image attribute is set. | \`::part(image)\` |
| \`initials\` | The container that wraps the avatar's initials. | \`::part(initials)\` |

### Dependencies

This component automatically imports the following elements. Sub-dependencies, if any exist, will also be included in this list.

-   [`<wa-icon>`](https://webawesome.com/docs/components/icon)

## Examples

### Image

To use an image for the avatar, set the `image` and `label` attributes. This will take priority and be shown over initials and icons. Avatar images can be lazily loaded by setting the `loading` attribute to `lazy`.

```html
<wa-avatar
  image="https://images.unsplash.com/photo-1529778873920-4da4926a72c2?ixlib=rb-1.2.1&auto=format&fit=crop&w=300&q=80"
  label="Avatar of a gray tabby kitten looking down"
></wa-avatar>
<wa-avatar
  image="https://images.unsplash.com/photo-1591871937573-74dbba515c4c?ixlib=rb-1.2.1&auto=format&fit=crop&w=300&q=80"
  label="Avatar of a white and grey kitten on grey textile"
  loading="lazy"
></wa-avatar>
```

### Initials

When you don't have an image to use, you can set the `initials` attribute to show something more personalized than an icon.

```html
<wa-avatar initials="WA" label="Avatar with initials: WA"></wa-avatar>
```

### Custom Icon

When no image or initials are set, an icon will be shown. The default avatar shows a generic "user" icon, but you can customize this with the `icon` slot.

```html
<wa-avatar label="Avatar with an image icon">
  <wa-icon slot="icon" name="image"></wa-icon>
</wa-avatar>

<wa-avatar label="Avatar with an archive icon">
  <wa-icon slot="icon" name="archive"></wa-icon>
</wa-avatar>

<wa-avatar label="Avatar with a briefcase icon">
  <wa-icon slot="icon" name="briefcase"></wa-icon>
</wa-avatar>
```

### Shape

Avatars can be shaped using the `shape` attribute.

```html
<wa-avatar shape="square" label="Square avatar"></wa-avatar>
<wa-avatar shape="rounded" label="Rounded avatar"></wa-avatar>
<wa-avatar shape="circle" label="Circle avatar"></wa-avatar>
```

### Avatar Groups

You can group avatars with a few lines of CSS.

```html
<div class="avatar-group">
  <wa-avatar
    image="https://images.unsplash.com/photo-1490150028299-bf57d78394e0?ixid=MXwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHw%3D&ixlib=rb-1.2.1&auto=format&fit=crop&w=256&h=256&q=80&crop=right"
    label="Avatar 1 of 4"
  ></wa-avatar>

  <wa-avatar
    image="https://images.unsplash.com/photo-1503454537195-1dcabb73ffb9?ixid=MXwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHw%3D&ixlib=rb-1.2.1&auto=format&fit=crop&w=256&h=256&crop=left&q=80"
    label="Avatar 2 of 4"
  ></wa-avatar>

  <wa-avatar
    image="https://images.unsplash.com/photo-1456439663599-95b042d50252?ixid=MXwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHw%3D&ixlib=rb-1.2.1&auto=format&fit=crop&w=256&h=256&crop=left&q=80"
    label="Avatar 3 of 4"
  ></wa-avatar>

  <wa-avatar
    image="https://images.unsplash.com/flagged/photo-1554078875-e37cb8b0e27d?ixid=MXwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHw%3D&ixlib=rb-1.2.1&auto=format&fit=crop&w=256&h=256&crop=top&q=80"
    label="Avatar 4 of 4"
  ></wa-avatar>
</div>

<style>
  .avatar-group wa-avatar:not(:first-of-type) {
    margin-left: calc(-1 * var(--wa-space-m));
  }

  .avatar-group wa-avatar {
    border: solid 2px var(--wa-color-surface-default);
  }
</style>
```
