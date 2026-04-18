import React, { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import type { FolderItem, SyncCacheEntry } from "./index";

type LsRow = { id: string; title: string; url: string; ext: string; stale: boolean };

type Props = {
  fetchFresh: () => Promise<LsRow[]>;
  cache: LsRow[];
};

export function LsView({ fetchFresh, cache }: Props) {
  const { exit } = useApp();
  const [rows, setRows] = useState<LsRow[]>(cache);
  const [status, setStatus] = useState<"loading" | "done">(cache.length ? "loading" : "loading");

  useEffect(() => {
    fetchFresh().then(fresh => {
      setRows(fresh);
      setStatus("done");
      setTimeout(() => exit(), 80);
    }).catch(err => {
      setStatus("done");
      setTimeout(() => exit(), 80);
    });
  }, []);

  return (
    <Box flexDirection="column">
      {rows.map(row => (
        <Box key={row.id}>
          <Text color={row.stale ? "gray" : undefined}>
            {`  \x1b]8;;${row.url}\x1b\\${row.title}\x1b]8;;\x1b\\ `}
          </Text>
          <Text dimColor>{row.ext}</Text>
          {row.stale && <Text color="gray"> (cached)</Text>}
        </Box>
      ))}
      {status === "loading" && (
        <Text color="gray">  fetching…</Text>
      )}
      {status === "done" && (
        <Text color="green">  ✓ up to date</Text>
      )}
    </Box>
  );
}
