fn plan(source: &[u16], blocks: &[[u32; 2]], headers: &[[u32; 2]]) -> Vec<u32> {
    let mut boundaries: Vec<_> = blocks
        .iter()
        .flat_map(|&[start, end]| [(start, 1_isize), (end, -1_isize)])
        .collect();
    boundaries.sort_unstable_by_key(|&(offset, _)| offset);
    let mut boundaries = boundaries.into_iter().peekable();
    let mut headers = headers.iter().peekable();
    let mut depth = 0_isize;
    let mut offset = 0_u32;
    let mut edits = Vec::new();
    for line in source.split_inclusive(|&unit| unit == 10) {
        while boundaries.peek().is_some_and(|&(start, _)| start <= offset) {
            depth += boundaries.next().unwrap().1;
        }
        while headers.peek().is_some_and(|range| range[1] <= offset) {
            headers.next();
        }
        if depth > 0 && !headers.peek().is_some_and(|range| range[0] < offset) {
            let prefix = 2 * depth as usize;
            let leading_spaces = line.iter().take_while(|&&unit| unit == 32).count();
            let bare = matches!(line, [10] | [13, 10]);
            if leading_spaces == prefix && matches!(&line[prefix..], [10] | [13, 10]) {
                edits.extend([offset, prefix as u32, 0]);
            } else if leading_spaces < prefix && !bare {
                edits.extend([offset, 0, prefix as u32]);
            }
        }
        offset += line.len() as u32;
    }
    edits
}

#[no_mangle]
pub extern "C" fn formatter_buffer_new(length: u32) -> *mut Vec<u32> {
    Box::into_raw(Box::new(vec![0; length as usize]))
}

/// # Safety
/// Buffer is live and the returned pointer is used only until the next call
/// that mutates or frees that buffer.
#[no_mangle]
pub unsafe extern "C" fn formatter_buffer_data(buffer: *mut Vec<u32>) -> *mut u32 {
    (*buffer).as_mut_ptr()
}

/// # Safety
/// Buffer is live.
#[no_mangle]
pub unsafe extern "C" fn formatter_buffer_length(buffer: *const Vec<u32>) -> u32 {
    (*buffer).len() as u32
}

/// # Safety
/// Buffer came from formatter_buffer_new and has not been freed.
#[no_mangle]
pub unsafe extern "C" fn formatter_buffer_free(buffer: *mut Vec<u32>) {
    drop(Box::from_raw(buffer));
}

/// Replace the input ranges with triples of source offset, deletion length
/// and number of spaces to insert. All offsets and lengths count UTF-16 units.
///
/// # Safety
/// Buffer is live and starts with the number of block ranges, followed by
/// block pairs and then opening-tag pairs in authored order. Source points to
/// length readable UTF-16 units disjoint from the buffer.
#[no_mangle]
pub unsafe extern "C" fn formatter_plan(source: *const u16, length: u32, buffer: *mut Vec<u32>) {
    let words = &mut *buffer;
    let (blocks, headers) = words[1..].as_chunks::<2>().0.split_at(words[0] as usize);
    *words = plan(
        std::slice::from_raw_parts(source, length as usize),
        blocks,
        headers,
    );
}

#[cfg(test)]
mod tests {
    use super::plan;

    #[test]
    fn plans_edits_at_utf16_line_starts() {
        let source: Vec<_> = "🌱<Outer>\n  \r\n~~~\n😀  \n~~~\n</Outer>"
            .encode_utf16()
            .collect();
        assert_eq!(
            plan(&source, &[[10, 27]], &[[2, 9]]),
            [10, 2, 0, 14, 0, 2, 18, 0, 2, 23, 0, 2]
        );
    }
}
