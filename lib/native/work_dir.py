from contextlib import contextmanager
from uuid import uuid4


@contextmanager
def work_dir(parent):
    # On modern Windows Python, tempfile's 0700 directory ACL can exclude a sandboxed child.
    folder = parent.resolve() / f"ios-build-{uuid4().hex}"
    folder.mkdir()
    try:
        yield folder
    finally:
        for file in folder.iterdir():
            file.unlink()
        folder.rmdir()
