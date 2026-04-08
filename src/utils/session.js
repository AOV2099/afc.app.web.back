export function sessionKey(sessionId) {
  return `sess:${sessionId}`;
}

export function safeUserPayload(row) {
  if (!row) return null;

  const careerId = row.career_id ?? null;
  const careerName = row.career_name ?? null;
  const careerFaculty = row.career_faculty ?? null;

  return {
    id: row.id,
    email: row.email,
    first_name: row.first_name,
    last_name: row.last_name,
    student_id: row.student_id ?? null,
    career_id: careerId,
    career_name: careerName,
    career_faculty: careerFaculty,
    career:
      careerId === null
        ? null
        : {
            id: careerId,
            name: careerName,
            faculty: careerFaculty,
          },
    status: row.status,
    ...(row.role ? { role: row.role } : {}),
  };
}
