// Decodes .rgd files with Microsoft's NRBF decoder and walks every object.
// Exit code 0 when all files decode. Prints RGD_Slot contents per slot array.
using System.Formats.Nrbf;

int failures = 0;
foreach (var path in args)
{
    try
    {
        using var fs = File.OpenRead(path);
        var root = NrbfDecoder.DecodeClassRecord(fs, leaveOpen: false);
        var seen = new HashSet<SerializationRecordId>();
        int objects = 0, slots = 0;
        void Walk(SerializationRecord? r)
        {
            if (r is null || !seen.Add(r.Id)) return;
            objects++;
            switch (r)
            {
                case ClassRecord c:
                    if (c.TypeName.FullName == "RGD_Slot") slots++;
                    foreach (var m in c.MemberNames)
                        if (c.GetRawValue(m) is SerializationRecord child) Walk(child);
                    break;
                case ArrayRecord ar when ar.Rank == 1:
                    foreach (var e in Elements(ar)) if (e is SerializationRecord child) Walk(child);
                    break;
            }
        }
        Walk(root);
        Console.WriteLine($"OK   {Path.GetFileName(path)}: root={root.TypeName.FullName} objects={objects} slots={slots}");
    }
    catch (Exception e)
    {
        failures++;
        Console.WriteLine($"FAIL {Path.GetFileName(path)}: {e.GetType().Name}: {e.Message}");
    }
}
return failures == 0 ? 0 : 1;

// Element array types differ by element kind: custom classes, object/string, or primitives (no records inside).
static IEnumerable<object?> Elements(ArrayRecord ar)
{
    if (ar is SZArrayRecord<SerializationRecord> sz) return sz.GetArray();
    Exception? last = null;
    foreach (var t in new[] { typeof(ClassRecord[]), typeof(SerializationRecord[]), typeof(object[]), typeof(string[]) })
    {
        try { return ar.GetArray(t, allowNulls: true).Cast<object?>().ToArray(); }
        catch (Exception ex) { last = ex; }
    }
    var element = ar.TypeName.GetElementType().FullName;
    if (element.StartsWith("System.")) return [];
    throw new InvalidOperationException($"Cannot read array of {element}: {last?.Message}");
}
