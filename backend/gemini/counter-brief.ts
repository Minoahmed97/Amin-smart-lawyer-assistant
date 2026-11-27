const streamChunkSize = 1200;
      for (let offset = 0; offset < finalText.length; offset += streamChunkSize) {
        res.write(JSON.stringify({ type: 'chunk', text: finalText.slice(offset, offset + streamChunkSize) }) + '\n');
      }
      
