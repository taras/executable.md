use pulldown_cmark::{Event, Parser};

#[derive(Clone, Copy)]
struct Item {
    size: usize,
    marker: u8,
    initial_blank: bool,
    further: bool,
}

enum Container {
    Quote,
    Item(Item),
}

#[derive(Clone, Copy, Default, PartialEq)]
enum Leaf {
    #[default]
    None,
    Paragraph,
    Code,
    Fence(u8, usize),
    Html(Option<&'static str>),
}

#[derive(Default)]
pub struct Tracker {
    containers: Vec<Container>,
    leaf: Leaf,
    flags: u32,
    content_column: usize,
    fence_marker: usize,
    fence_html: Option<Leaf>,
    possible_definitions: Option<String>,
}

const CODE: u32 = 1;
const ACCEPTED: u32 = 2;
const LAZY: u32 = 4;
const CONTINUES: u32 = 8;
const FENCE_OPEN: u32 = 16;
const FENCE_BODY: u32 = 32;
const FENCE_CLOSE: u32 = 64;
const FENCE_EXIT: u32 = 128;
#[cfg(test)]
const NO_HEADER: u32 = u32::MAX;

fn expand(text: &[u16]) -> (Vec<u8>, Vec<usize>) {
    let mut line = Vec::with_capacity(text.len());
    let mut original = Vec::with_capacity(text.len());
    for (offset, &unit) in text.iter().enumerate() {
        if unit == 9 {
            let next_stop = line.len() + 4 - line.len() % 4;
            line.resize(next_stop, b' ');
            original.resize(next_stop, offset);
        } else {
            // Keep each UTF-16 unit, including an unpaired surrogate, one column wide.
            line.push(if unit < 128 { unit as u8 } else { b'\x7f' });
            original.push(offset);
        }
    }
    (line, original)
}

fn spaces(line: &[u8], at: usize) -> usize {
    line[at..].iter().take_while(|&&byte| byte == b' ').count()
}

fn thematic(rest: &[u8]) -> bool {
    let marker = rest.first().copied().unwrap_or_default();
    matches!(marker, b'-' | b'*' | b'_')
        && rest.iter().all(|&byte| byte == marker || byte == b' ')
        && rest.iter().filter(|&&byte| byte == marker).count() >= 3
}

fn item_start(
    line: &[u8],
    at: usize,
    interrupt: bool,
    sibling: Option<Item>,
) -> Option<(Item, usize)> {
    let indent = spaces(line, at);
    if indent >= 4 {
        return None;
    }
    let start = at + indent;
    let first = *line.get(start)?;
    let mut cursor = start + 1;
    let marker = match first {
        b'-' | b'+' | b'*' if !thematic(&line[start..]) => first,
        b'0'..=b'9' => {
            let digits = line[start..]
                .iter()
                .take(9)
                .take_while(|byte| byte.is_ascii_digit())
                .count();
            let number = &line[start..start + digits];
            if interrupt
                && !(number.last() == Some(&b'1')
                    && number[..number.len() - 1]
                        .iter()
                        .all(|&digit| digit == b'0'))
            {
                return None;
            }
            let marker = *line.get(start + digits)?;
            if !matches!(marker, b'.' | b')') {
                return None;
            }
            cursor = start + digits + 1;
            marker
        }
        _ => return None,
    };
    if sibling.is_some_and(|item| item.marker != marker) {
        return None;
    }
    let gap = spaces(line, cursor);
    let initial_blank = cursor + gap == line.len();
    if (initial_blank && interrupt) || (!initial_blank && gap == 0) {
        return None;
    }
    let padding = if initial_blank || gap > 4 { 1 } else { gap };
    let item = Item {
        size: cursor - at + padding,
        marker,
        initial_blank,
        further: false,
    };
    Some((
        item,
        if initial_blank {
            cursor
        } else {
            cursor + padding
        },
    ))
}

fn quote_start(line: &[u8], at: usize) -> Option<usize> {
    let indent = spaces(line, at);
    if indent >= 4 || line.get(at + indent) != Some(&b'>') {
        return None;
    }
    let end = at + indent + 1;
    Some(end + usize::from(line.get(end) == Some(&b' ')))
}

fn run(rest: &[u8], marker: u8) -> usize {
    rest.iter().take_while(|&&byte| byte == marker).count()
}

fn fence_length(rest: &[u8]) -> Option<usize> {
    let marker = *rest.first()?;
    if !matches!(marker, b'`' | b'~') {
        return None;
    }
    let length = run(rest, marker);
    (length >= 3 && (marker != b'`' || !rest[length..].contains(&b'`'))).then_some(length)
}

const HTML_BLOCK_NAMES: &str = "address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul";

fn html_start(rest: &str, paragraph: bool) -> Option<Leaf> {
    let lower = rest.to_ascii_lowercase();
    let after_open = &lower[1..];
    let name = after_open
        .trim_start_matches('/')
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .next()
        .unwrap_or("");
    let suffix = &after_open[usize::from(after_open.starts_with('/')) + name.len()..];
    let terminator = if !after_open.starts_with('/')
        && matches!(name, "pre" | "script" | "style" | "textarea")
        && (suffix.is_empty() || suffix.starts_with([' ', '>']))
    {
        Some("raw")
    } else if rest.starts_with("<!--") {
        Some("-->")
    } else if rest.starts_with("<?") {
        Some("?>")
    } else if rest.starts_with("<![CDATA[") {
        Some("]]>")
    } else if rest.as_bytes().get(1) == Some(&b'!')
        && rest.as_bytes().get(2).is_some_and(u8::is_ascii_alphabetic)
    {
        Some(">")
    } else if (suffix.is_empty() || suffix.starts_with([' ', '>']) || suffix.starts_with("/>"))
        && HTML_BLOCK_NAMES
            .split_ascii_whitespace()
            .any(|block| block == name)
    {
        return Some(Leaf::Html(None));
    } else if !paragraph
        && matches!(
            Parser::new(rest).next(),
            Some(Event::Start(pulldown_cmark::Tag::HtmlBlock))
        )
    {
        return Some(Leaf::Html(None));
    } else {
        return None;
    };
    Some(if html_ends(rest, terminator.unwrap()) {
        Leaf::None
    } else {
        Leaf::Html(terminator)
    })
}

fn html_ends(rest: &str, terminator: &str) -> bool {
    if terminator == "raw" {
        let lower = rest.to_ascii_lowercase();
        return ["</pre>", "</script>", "</style>", "</textarea>"]
            .iter()
            .any(|end| lower.contains(end));
    }
    rest.contains(terminator)
}

impl Tracker {
    #[cfg(test)]
    fn feed(&mut self, text: &[u16], candidate: u32) -> u32 {
        self.feed_line(text, candidate, 1)
    }

    fn feed_line(&mut self, text: &[u16], candidate: u32, fence_mode: u32) -> u32 {
        let had_fence = matches!(self.leaf, Leaf::Fence(..));
        let text = text.strip_suffix(&[13]).unwrap_or(text);
        let (line, original) = expand(text);
        let mut at = 0;
        let mut matched = 0;
        for container in &mut self.containers {
            match container {
                Container::Quote => {
                    let Some(end) = quote_start(&line, at) else {
                        break;
                    };
                    at = end;
                }
                Container::Item(item) => {
                    let indent = spaces(&line, at);
                    if at + indent == line.len() {
                        item.further |= item.initial_blank;
                        at += item.size.min(indent);
                    } else {
                        let leaves = item.further || indent == 0;
                        item.further = false;
                        item.initial_blank = false;
                        if !leaves && indent >= item.size {
                            at += item.size;
                        } else {
                            let Some((sibling, end)) = item_start(&line, at, false, Some(*item))
                            else {
                                break;
                            };
                            *item = sibling;
                            at = end;
                            self.leaf = Leaf::None;
                            matched += 1;
                            self.containers.truncate(matched);
                            break;
                        }
                    }
                }
            }
            matched += 1;
        }
        let mut lazy = matched < self.containers.len();
        let interrupt = !lazy && self.leaf == Leaf::Paragraph;
        if lazy || !matches!(self.leaf, Leaf::Fence(..) | Leaf::Html(_)) {
            loop {
                let (container, end) = if let Some(end) = quote_start(&line, at) {
                    (Container::Quote, end)
                } else if let Some((item, end)) = item_start(&line, at, interrupt, None) {
                    (Container::Item(item), end)
                } else {
                    break;
                };
                self.containers.truncate(matched);
                lazy = false;
                self.leaf = Leaf::None;
                at = end;
                self.containers.push(container);
                matched += 1;
            }
        }

        self.content_column = at;
        let indent = spaces(&line, at);
        let content = at + indent;
        let rest = &line[content..];
        let raw = std::str::from_utf8(rest).expect("expanded line is ASCII");
        let before = self.leaf;
        let mut flags = if lazy { LAZY } else { 0 };
        if lazy && matches!(self.leaf, Leaf::Fence(..) | Leaf::Html(_) | Leaf::Code) {
            self.leaf = Leaf::None;
        }

        if had_fence && !matches!(self.leaf, Leaf::Fence(..)) {
            flags |= FENCE_EXIT;
            self.fence_html = None;
        }
        let opener = if indent < 4 && (fence_mode & 1 != 0 || (fence_mode & 4 != 0 && at > 0)) {
            fence_length(rest)
        } else {
            None
        };
        // XMD's physical fence syntax also applies inside HTML blocks.
        if fence_mode & 2 != 0 && at == 0 && opener.is_some() && matches!(self.leaf, Leaf::Html(_))
        {
            self.fence_html = Some(self.leaf);
            self.leaf = Leaf::None;
        }
        let mut fresh_paragraph = self.leaf != Leaf::Paragraph;
        match self.leaf {
            Leaf::Fence(marker, length) => {
                if self.fence_html.is_some_and(|html| match html {
                    Leaf::Html(Some(end)) => html_ends(raw, end),
                    Leaf::Html(None) => rest.is_empty(),
                    _ => false,
                }) {
                    self.fence_html = None;
                }
                let closing = run(rest, marker);
                if indent < 4 && closing >= length && spaces(rest, closing) == rest.len() - closing
                {
                    self.leaf = self.fence_html.take().unwrap_or(Leaf::None);
                    flags |= FENCE_CLOSE;
                } else {
                    flags |= FENCE_BODY;
                    if !rest.is_empty() {
                        flags |= CODE;
                    }
                }
            }
            Leaf::Html(Some(end)) => {
                if html_ends(raw, end) {
                    self.leaf = Leaf::None;
                }
            }
            Leaf::Html(None) if !rest.is_empty() => {}
            Leaf::Paragraph | Leaf::Html(None) if rest.is_empty() => self.leaf = Leaf::None,
            _ if rest.is_empty() => {}
            Leaf::Paragraph if indent >= 4 => flags |= CONTINUES,
            _ if indent >= 4 => {
                self.leaf = Leaf::Code;
                flags |= CODE;
            }
            _ => {
                let first = rest[0];
                let paragraph = self.leaf == Leaf::Paragraph;
                let marker_count = run(rest, first);
                let heading = first == b'#'
                    && marker_count <= 6
                    && (marker_count == rest.len() || rest[marker_count] == b' ');
                let setext = paragraph
                    && !lazy
                    && matches!(first, b'=' | b'-')
                    && spaces(rest, marker_count) == rest.len() - marker_count;
                // Definitions keep paragraph continuation until setext needs
                // to know whether any paragraph text survives their removal.
                let definitions_only = setext
                    && self
                        .possible_definitions
                        .as_ref()
                        .is_some_and(|text| Parser::new(text).next().is_none());
                if heading || thematic(rest) || (setext && !definitions_only) {
                    self.leaf = Leaf::None;
                } else if let Some(length) = opener {
                    self.leaf = Leaf::Fence(first, length);
                    self.fence_marker = original[content];
                    flags |= FENCE_OPEN;
                } else if first == b'<' && original[content] == candidate as usize {
                    self.leaf = Leaf::None;
                    flags |= ACCEPTED;
                } else if let Some(html) = (first == b'<')
                    .then(|| html_start(raw, paragraph))
                    .flatten()
                {
                    self.leaf = html;
                } else {
                    if definitions_only {
                        fresh_paragraph = true;
                    }
                    if paragraph {
                        flags |= CONTINUES;
                    }
                    self.leaf = Leaf::Paragraph;
                }
            }
        }
        if lazy && !(before == Leaf::Paragraph && flags & CONTINUES != 0) {
            self.containers.truncate(matched);
        }
        if self.leaf != Leaf::Paragraph || fresh_paragraph {
            self.possible_definitions = None;
        }
        if self.leaf == Leaf::Paragraph {
            if fresh_paragraph && rest.first() == Some(&b'[') {
                self.possible_definitions = Some(String::new());
            }
            if let Some(text_so_far) = &mut self.possible_definitions {
                let start = if fresh_paragraph { content } else { at };
                text_so_far
                    .push_str(std::str::from_utf8(&line[start..]).expect("expanded line is ASCII"));
                text_so_far.push('\n');
            }
        }
        self.flags = flags;
        flags
    }

    fn header(&mut self, accepted: bool, blank_rest: bool, minimum_column: usize) -> u32 {
        let after_paragraph =
            !accepted && blank_rest && self.flags & (CODE | LAZY | CONTINUES) == CONTINUES;
        if !accepted && !after_paragraph {
            return 0;
        }
        if minimum_column < self.content_column {
            return 2;
        }
        if after_paragraph {
            self.leaf = Leaf::None;
        }
        1
    }
}

#[no_mangle]
pub extern "C" fn tracker_new() -> *mut Tracker {
    Box::into_raw(Box::new(Tracker::default()))
}

/// # Safety
/// Pointer comes from tracker_new and has not been freed.
#[no_mangle]
pub unsafe extern "C" fn tracker_free(tracker: *mut Tracker) {
    drop(Box::from_raw(tracker));
}

/// # Safety
/// Tracker is live and text points to length readable UTF-16 units for this call.
#[no_mangle]
pub unsafe extern "C" fn tracker_feed(
    tracker: *mut Tracker,
    text: *const u16,
    length: u32,
    candidate: u32,
    fence_mode: u32,
) -> u32 {
    let units = if length == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(text, length as usize)
    };
    (*tracker).feed_line(units, candidate, fence_mode)
}

/// # Safety
/// Tracker is live and the last feed reported FENCE_OPEN.
#[no_mangle]
pub unsafe extern "C" fn tracker_fence_marker(tracker: *const Tracker) -> u32 {
    (*tracker).fence_marker as u32
}

/// # Safety
/// Tracker is live.
#[no_mangle]
pub unsafe extern "C" fn tracker_header(
    tracker: *mut Tracker,
    accepted: u32,
    blank_rest: u32,
    minimum_column: u32,
) -> u32 {
    (*tracker).header(accepted != 0, blank_rest != 0, minimum_column as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn references_leave_a_lazy_paragraph_until_setext() {
        for source in [
            "[foo]: /url\n===\n    x",
            "[foo]: /url\n-\n    x",
            "[ref]:\n    ===\n===\n    x",
            "[foo]: /url\n    x",
        ] {
            let mut tracker = Tracker::default();
            let flags = source
                .lines()
                .map(|line| tracker.feed(&line.encode_utf16().collect::<Vec<_>>(), NO_HEADER))
                .last()
                .unwrap();
            assert_eq!(flags & CODE, 0, "{source:?}");
        }
    }

    #[test]
    fn container_fences_own_only_matched_lines() {
        let mut tracker = Tracker::default();
        let lines = [
            ("> ~~~", FENCE_OPEN, Some(2)),
            ("> ", FENCE_BODY, None),
            ("> \ttext", FENCE_BODY | CODE, None),
            ("- ```", FENCE_EXIT | FENCE_OPEN, Some(2)),
            ("  text", FENCE_BODY | CODE, None),
            ("- ~~~", FENCE_EXIT | FENCE_OPEN, Some(2)),
            ("  ~~~\t", FENCE_CLOSE, None),
            ("<Tag />", LAZY, None),
        ];
        for (line, expected, marker) in lines {
            let flags = tracker.feed(&line.encode_utf16().collect::<Vec<_>>(), NO_HEADER);
            assert_eq!(flags, expected, "{line:?}");
            if let Some(marker) = marker {
                assert_eq!(tracker.fence_marker, marker);
            }
        }
    }

    #[test]
    fn list_columns_and_code() {
        let golden = [
            (
                "prose\n01. item\n\n    <File />",
                vec![(0, 0), (4, 0), (0, 0), (4, 0)],
            ),
            (
                "10. one\n\n    - two\n\n      <File />\n          <File />",
                vec![(4, 0), (0, 0), (6, 0), (0, 0), (6, 0), (6, 0)],
            ),
            (
                "123456789) x\n\n           <File />\n\n               <File />",
                vec![(11, 0), (0, 0), (11, 0), (0, 0), (11, CODE)],
            ),
            (
                "10.\tx\n\n\t-\tx\n\n\t\t<File />\n\n\t\t\t<File />",
                vec![(4, 0), (0, 0), (8, 0), (0, 0), (8, 0), (0, 0), (8, CODE)],
            ),
            (
                "-\t  <File />\n\n    <File />",
                vec![(2, CODE), (0, 0), (2, 0)],
            ),
        ];
        for (source, expected) in golden {
            let mut tracker = Tracker::default();
            for (line, (column, code)) in source.lines().zip(expected) {
                let units = line.encode_utf16().collect::<Vec<_>>();
                assert_eq!(
                    tracker.feed(&units, NO_HEADER) & CODE,
                    code,
                    "{source:?} {line:?}"
                );
                assert_eq!(tracker.content_column, column, "{source:?} {line:?}");
            }
        }
    }
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn tracker_input(length: u32) -> *mut u16 {
    Box::into_raw(vec![0u16; length as usize].into_boxed_slice()).cast()
}

/// # Safety
/// Pointer and length are the matching allocation from tracker_input.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub unsafe extern "C" fn tracker_input_free(input: *mut u16, length: u32) {
    drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
        input,
        length as usize,
    )));
}
