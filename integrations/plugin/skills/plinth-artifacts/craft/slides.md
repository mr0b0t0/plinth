# Craft: decks (type slides)

How to make a Markdown deck that presents well. Plinth chooses each slide's layout, type sizes and
colors from what the slide holds, so what you control is the story, what goes on each slide and
which kind of slide it is.

## Outline first

- Write every slide title before any slide, in one style: short topic titles ("Market", "Team"), or
  action titles that each make a point ("Asia is our largest market"). Read the titles alone: they
  should tell the story.
- Share the outline (titles only) in your reply as you build. Wait for approval only when the
  request was unclear.
- A title introduces its slide; it is not the punchline. Avoid dramatic or faux-insight titles
  ("The magic moment", "It's not X. It's Y.").

## One idea per slide

- One point per slide; two short slides beat one crowded one. A slide that needs more than about
  six bullets, or a table of more than about eight rows, is two slides.
- Bullets are short phrases, mostly one line each. The explanation goes in the slide's `Note:`,
  which the presenter sees, not on the slide.
- Fit the length to the time: about one slide a minute for a talk.

## A type scale, by heading level

Plinth sets sizes by heading level, so use each level the same way on every slide:

- `#` only for the title slide (and a closing slide), with one or two short lines under it.
- `##` for the title of every other slide.
- `###` for a column's heading (after `|||`) or a group inside a slide. Never `####`.
- Body text and bullets are one size throughout. Bold a word or two for emphasis, never a whole
  bullet.

## Rhythm: vary the kind of slide

A deck has one theme, so vary the kinds of slide on purpose, the way a designed deck varies its
background tones:

- **Open and close** with a title slide: `#` and a line under it.
- **Section slides**, a `##` heading alone on its slide, between the parts of the story. Plinth sets
  them large with the accent bar.
- **One statement slide** (two at most) for the sentence or number you want people to remember: a
  `##` heading alone that is the statement itself ("Churn fell to 2%").
- In between, content slides: a heading with bullets, a heading with an image, two or three columns
  (`|||`) for before and after or options side by side, a table.
- Slides of the same kind are built the same way, so the heading stays in one place as people flip
  through.

## Vertical space

A 16:9 slide is a fixed 1280 by 720 canvas (4:3 is 1024 by 768) and never scrolls. Text that does
not fit shrinks in steps down to 55%, and past that it is cut. Plan so nothing shrinks:

- Under a `##` title a slide holds about ten lines of body text. Columns hold the same number of
  lines in a narrower measure, so their bullets wrap sooner.
- A table holds about eight rows plus its header. Split a longer one, or put it in a doc and link it.
- An image under a heading is shown at most 400 px tall; an image alone on its slide, with or
  without a heading, fills the slide.
- Plinth warns `slide_dense` past 14 lines or 900 characters on a slide: split the slide, or move
  the detail into its notes.

## Contrast and images

- Plinth's themes keep slide text readable; your images must be readable too. Text in a chart or
  diagram image needs 4.5:1 contrast against the image's background (3:1 for large labels and for
  the chart's marks), and labels at least about 24 px at the size the slide shows them.
- With `theme: auto` the deck follows each viewer's light or dark scheme. When your images are drawn
  for one background, set `theme: light` or `theme: dark` to match them, or give each image its own
  background.
- Make images at the slide's size or twice it, never a screenshot of a page with small text.

## Numbers and notes

- Never invent a statistic. Every number on a slide comes from the person or a source you read;
  name the source in a short line on the slide or in its notes.
- Add speaker notes when asked, or when someone else will present. Write them as what the presenter
  will say, in full sentences. Anyone who can open the deck can read the notes, so nothing private
  goes there.

## Changing a deck

- Change only what was asked: the other slides, their order and their wording stay as they are.
  Suggest broader changes in your reply.
