// l10n-rust-tool CLI — extract / apply over a Rust source tree (SPEC §1, §7).
use l10n_rust_tool::extract::{process_source, Entry, ReviewItem};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

fn collect_rs_files(root: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .filter(|p| {
            p.extension().map(|x| x == "rs").unwrap_or(false)
                && !p.components().any(|c| c.as_os_str() == "target")
        })
        .collect();
    files.sort();
    files
}

fn posix_rel(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .to_string_lossy()
        .replace('\\', "/")
}

#[derive(serde::Serialize)]
struct CorpusOut {
    tool: &'static str,
    file_count: usize,
    entries: Vec<Entry>,
    review: Vec<ReviewItem>,
}

fn merge_entry(map: &mut BTreeMap<String, Entry>, e: Entry) {
    let existing = map
        .entry(e.id.clone())
        .or_insert_with(|| Entry {
            id: e.id.clone(),
            source: e.source.clone(),
            kinds: Vec::new(),
            hint: String::new(),
            placeholders: e.placeholders.clone(),
            in_test: e.in_test,
            occurrences: Vec::new(),
        });
    for k in e.kinds {
        if !existing.kinds.contains(&k) {
            existing.kinds.push(k);
        }
    }
    if !e.hint.is_empty() && !existing.hint.contains(&e.hint) {
        existing.hint = if existing.hint.is_empty() {
            e.hint.clone()
        } else {
            format!("{} | {}", existing.hint, e.hint)
        };
    }
    if e.in_test {
        existing.in_test = true;
    }
    existing.occurrences.extend(e.occurrences);
    existing
        .occurrences
        .sort_by(|a, b| a.file.cmp(&b.file).then(a.start.cmp(&b.start)));
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let get = |k: &str| -> Option<String> {
        let i = args.iter().position(|a| a == k)?;
        args.get(i + 1).cloned()
    };
    let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("");

    match cmd {
        "extract" => {
            let src = PathBuf::from(get("--src").expect("--src"));
            let out = get("--out").expect("--out");
            let prefix = get("--prefix").unwrap_or_default();
            let files = collect_rs_files(&src);
            let mut entries: BTreeMap<String, Entry> = BTreeMap::new();
            let mut review = Vec::new();
            for f in &files {
                let text = fs::read_to_string(f).expect("read");
                let mut rel = posix_rel(&src, f);
                if !prefix.is_empty() {
                    rel = format!("{}/{}", prefix.trim_end_matches('/'), rel);
                }
                let r = process_source(&text, &rel, None, None, None);
                for e in r.entries {
                    merge_entry(&mut entries, e);
                }
                review.extend(r.review);
            }
            let corpus = CorpusOut {
                tool: "rust",
                file_count: files.len(),
                entries: entries.into_values().collect(),
                review,
            };
            fs::write(&out, serde_json::to_string_pretty(&corpus).unwrap() + "\n")
                .expect("write");
            eprintln!(
                "rust-tool: {} files, {} entries, {} review items",
                corpus.file_count,
                corpus.entries.len(),
                corpus.review.len()
            );
        }
        "apply" => {
            let src = PathBuf::from(get("--src").expect("--src"));
            let tm: HashMap<String, String> = serde_json::from_str(
                &fs::read_to_string(get("--tm").expect("--tm")).expect("read tm"),
            )
            .expect("tm json");
            let deny: HashSet<String> = match get("--deny") {
                Some(p) => serde_json::from_str(&fs::read_to_string(p).expect("read deny"))
                    .expect("deny json"),
                None => HashSet::new(),
            };
            // occurrence-level denies: [{file, line}, …] from denylist.json .occurrences
            let deny_occ: HashSet<(String, usize)> = match get("--deny-occ") {
                Some(p) => {
                    let raw: Vec<serde_json::Value> =
                        serde_json::from_str(&fs::read_to_string(p).expect("read deny-occ"))
                            .expect("deny-occ json");
                    raw.into_iter()
                        .filter_map(|v| {
                            let f = v.get("file")?.as_str()?.to_string();
                            let l = v.get("line")?.as_u64()? as usize;
                            Some((f, l))
                        })
                        .collect()
                }
                None => HashSet::new(),
            };
            let files = collect_rs_files(&src);
            let mut changed = 0usize;
            for f in &files {
                let text = fs::read_to_string(f).expect("read");
                let rel = posix_rel(&src, f);
                let r = process_source(&text, &rel, Some(&tm), Some(&deny), Some(&deny_occ));
                if r.changed {
                    fs::write(f, r.new_text.unwrap()).expect("write");
                    changed += 1;
                }
                for rv in r.review.iter().filter(|x| x.item == "parse-error") {
                    eprintln!("WARN {}", rv.detail);
                }
            }
            eprintln!("rust-tool apply: {}/{} files rewritten", changed, files.len());
        }
        _ => {
            eprintln!("usage: l10n-rust-tool extract --src DIR --out FILE [--prefix P] | apply --src DIR --tm FILE [--deny FILE]");
            std::process::exit(2);
        }
    }
}
